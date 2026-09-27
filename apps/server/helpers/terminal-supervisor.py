"""Keep ownership of every terminal descendant until it has been reaped."""

from collections import deque
import ctypes
import json
import os
from pathlib import Path
import signal
import shutil
import sys
import time
import tempfile


CLOUDX_TERMINAL_SUPERVISOR_CONTRACT = "execution-json-v1"
PR_SET_PDEATHSIG = 1
PR_SET_CHILD_SUBREAPER = 36
SUPERVISOR_SIGNALS = (
    signal.SIGHUP, signal.SIGTERM, signal.SIGINT, signal.SIGQUIT,
    signal.SIGTSTP, signal.SIGTTIN, signal.SIGTTOU, signal.SIGPIPE,
)


class TerminalSupervisor:
    def __init__(self, directory, parent, execution, command):
        self.directory = Path(directory)
        self.parent = parent
        self.command = command
        self.execution = execution
        self.identity = {"pid": os.getpid()}
        self.children = Path(f"/proc/self/task/{os.getpid()}/children")
        self.worker = None
        self.worker_status = None
        self.stopping = False
        self.began = time.monotonic()
        self.events = deque(maxlen=64)

    def run(self):
        if sys.version_info < (3, 9):
            raise RuntimeError("Terminal supervision requires Python 3.9 or newer")
        if not self.command or not self.command[0]:
            raise RuntimeError("Terminal supervisor command is missing")
        self.children.read_text()
        self.own_orphaned_descendants()
        self.bind_execution()
        self.record("ready")
        self.write_receipt("ready", self.identity)
        try:
            if not self.stopping:
                self.launch_command()
            while self.reap_exited_children():
                if self.stopping or self.worker_status is not None:
                    self.kill_children()
                time.sleep(0.01)
        except BaseException:
            # Retain the subreaper until children are gone, including failed starts.
            while self.reap_exited_children():
                self.kill_children()
                time.sleep(0.01)
            raise
        event = self.command_exit()
        self.record("children-reaped", **event)
        self.write_receipt("complete", {**self.identity, **event})
        if self.execution is None:
            self.remove_ephemeral_receipts()
        else:
            self.record("durable-receipts-retained")
        self.retain_diagnostics()
        return event["exitCode"]

    def remove_ephemeral_receipts(self):
        self.record("awaiting-receipt-acknowledgement")
        # Keep an owner alive until the host has consumed the receipt or died.
        # A one-time getppid() check can miss a host exiting concurrently.
        while os.getppid() == self.parent:
            acknowledgement = self.directory / "acknowledged.json"
            if acknowledgement.exists():
                if json.loads(acknowledgement.read_text()) != self.identity:
                    raise RuntimeError("Terminal completion acknowledgement does not match its owner")
                self.record("receipt-acknowledged")
                break
            time.sleep(0.01)
        else:
            self.record("parent-exited")
        self.record("removing-ephemeral-receipts")
        shutil.rmtree(self.directory)
        self.record("ephemeral-receipts-removed")

    def record(self, phase, **values):
        self.events.append({"phase": phase, "elapsedMs": round((time.monotonic() - self.began) * 1000), **values})

    def diagnostics(self):
        return {"pid": os.getpid(), "parent": self.parent, "processGroup": os.getpgrp(),
                "started": Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19],
                "events": list(self.events)}

    def retain_diagnostics(self, error=None):
        parent = os.environ.get("CLOUDX_TERMINAL_DIAGNOSTICS_DIR")
        if not parent and error is None:
            return
        if error is not None:
            self.record("error", errorType=type(error).__name__, errno=getattr(error, "errno", None))
        try:
            if parent:
                Path(parent).mkdir(mode=0o700, parents=True, exist_ok=True)
            directory = Path(tempfile.mkdtemp(prefix="supervisor-", dir=parent))
            descriptor = os.open(directory / "lifecycle.json", os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, "w") as output:
                json.dump(self.diagnostics(), output)
        except OSError:
            # Diagnostic I/O must not replace the process or cleanup failure.
            pass

    def bind_execution(self):
        if self.execution is None:
            return
        if not isinstance(self.execution, dict) or any(
            not isinstance(self.execution.get(key), str) or not self.execution[key]
            for key in ("executionId", "directory", "bootId", "pidNamespace")
        ):
            raise RuntimeError("Terminal execution binding is invalid")
        boot_id = Path("/proc/sys/kernel/random/boot_id").read_text().strip()
        pid_namespace = os.readlink("/proc/self/ns/pid")
        started = Path("/proc/self/stat").read_text().rsplit(") ", 1)[1].split()[19]
        self.identity.update({
            "executionId": self.execution["executionId"], "bootId": boot_id,
            "pidNamespace": pid_namespace, "started": started,
        })
        if (
            self.execution["directory"] != str(self.directory)
            or self.execution["bootId"] != boot_id
            or self.execution["pidNamespace"] != pid_namespace
        ):
            raise RuntimeError("Terminal execution binding does not match the current boot and PID namespace")

    def own_orphaned_descendants(self):
        for number in SUPERVISOR_SIGNALS:
            signal.signal(number, signal.SIG_IGN)
        for number in (signal.SIGHUP, signal.SIGTERM):
            signal.signal(number, self.request_stop)
        signal.signal(signal.SIGCHLD, signal.SIG_DFL)
        libc = ctypes.CDLL(None, use_errno=True)
        libc.prctl.argtypes = [ctypes.c_int, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_ulong]
        libc.prctl.restype = ctypes.c_int
        for option, value in ((PR_SET_CHILD_SUBREAPER, 1), (PR_SET_PDEATHSIG, signal.SIGTERM)):
            if libc.prctl(option, value, 0, 0, 0) != 0:
                raise OSError(ctypes.get_errno(), "Linux terminal subreaper setup failed")
        if os.getppid() != self.parent:
            self.stopping = True

    def request_stop(self, _number, _frame):
        self.stopping = True

    def launch_command(self):
        read_gate, write_gate = os.pipe()
        try:
            self.worker = os.fork()
            if self.worker == 0:
                try:
                    os.close(write_gate)
                    os.setpgid(0, 0)
                    if os.read(read_gate, 1) != b"1":
                        os._exit(125)
                    os.close(read_gate)
                    for number in SUPERVISOR_SIGNALS:
                        signal.signal(number, signal.SIG_DFL)
                    os.execvpe(self.command[0], self.command, os.environ)
                except BaseException as error:
                    print(f"Terminal command failed to start: {error}", file=sys.stderr, flush=True)
                    os._exit(127)
            os.setpgid(self.worker, self.worker)
            self.record("command-launched", worker=self.child_identity(self.worker))
            if os.isatty(0):
                os.tcsetpgrp(0, self.worker)
            os.write(write_gate, b"1")
        finally:
            os.close(read_gate)
            os.close(write_gate)

    def reap_exited_children(self):
        while True:
            try:
                pid, status = os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                return False
            if pid == 0:
                return True
            if pid == self.worker:
                self.worker_status = status

    def kill_children(self):
        children = self.children.read_text().split()
        self.record("kill-children", children=[self.child_identity(int(child)) for child in children[:32]], count=len(children))
        # These are our unreaped children: their PIDs cannot be reused here.
        # Killing a parent reparents its descendants to this still-living owner.
        # waitpid's ECHILD proves completion even when adoption changes this list.
        for child in children:
            os.kill(int(child), signal.SIGKILL)

    def child_identity(self, pid):
        fields = Path(f"/proc/{pid}/stat").read_text().rsplit(") ", 1)[1].split()
        return {"pid": pid, "started": fields[19], "processGroup": int(fields[2]), "state": fields[0]}

    def command_exit(self):
        code = os.waitstatus_to_exitcode(self.worker_status) if self.worker_status is not None else 0
        return {"exitCode": code} if code >= 0 else {"exitCode": 0, "signal": -code}

    def write_receipt(self, name, value):
        temporary = self.directory / f"{name}.tmp"
        with temporary.open("w") as receipt:
            json.dump(value, receipt)
            if self.execution is not None:
                receipt.flush()
                os.fsync(receipt.fileno())
        temporary.replace(self.directory / f"{name}.json")
        if self.execution is not None:
            directory = os.open(self.directory, os.O_RDONLY | os.O_DIRECTORY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)


if __name__ == "__main__":
    supervisor = TerminalSupervisor(sys.argv[1], int(sys.argv[2]), None, sys.argv[4:])
    try:
        if len(sys.argv) < 4:
            raise RuntimeError("Terminal supervisor execution JSON argument is missing")
        try:
            supervisor.execution = json.loads(sys.argv[3])
        except json.JSONDecodeError as error:
            raise RuntimeError(
                f"Terminal supervisor execution JSON is invalid: {error}. "
                "A stale CloudX broker/server may be using incompatible supervisor arguments; "
                "the broker/server and helper must come from the same CloudX runtime."
            ) from error
        sys.exit(supervisor.run())
    except Exception as error:
        supervisor.retain_diagnostics(error)
        supervisor.write_receipt("error", {**supervisor.identity, "message": str(error),
                                           "diagnostics": list(supervisor.events)[-1]})
        sys.exit(125)
