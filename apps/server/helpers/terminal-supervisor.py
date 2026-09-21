"""Keep ownership of every terminal descendant until it has been reaped."""

import ctypes
import json
import os
from pathlib import Path
import signal
import shutil
import sys
import time


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

    def run(self):
        if sys.version_info < (3, 9):
            raise RuntimeError("Terminal supervision requires Python 3.9 or newer")
        self.children.read_text()
        self.own_orphaned_descendants()
        self.bind_execution()
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
        self.write_receipt("complete", {**self.identity, **event})
        if self.execution is None and os.getppid() != self.parent:
            shutil.rmtree(self.directory)
        return event["exitCode"]

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
        # These are our unreaped children: their PIDs cannot be reused here.
        # Killing a parent reparents its descendants to this still-living owner.
        # waitpid's ECHILD proves completion even when adoption changes this list.
        for child in children:
            os.kill(int(child), signal.SIGKILL)

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
    supervisor = TerminalSupervisor(sys.argv[1], int(sys.argv[2]), json.loads(sys.argv[3]), sys.argv[4:])
    try:
        sys.exit(supervisor.run())
    except Exception as error:
        supervisor.write_receipt("error", {**supervisor.identity, "message": str(error)})
        sys.exit(125)
