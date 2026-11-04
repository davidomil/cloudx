import { useEffect, useState } from "react";
import { KeyRound } from "lucide-react";
import type {
  HardwareStateView,
  HardwareSummary,
  JsonObject,
} from "@cloudx/shared";
import {
  hardwareRequestId,
  saveHardwareSshPassword,
} from "../../hardwareApi.js";
import { ControlButton } from "../Control.js";
import { HardwareDialog, type HardwareRun } from "./HardwareControls.js";

export function SshKeyRegistration({
  state,
  summary,
  active,
  busy,
  run,
}: {
  state: HardwareStateView;
  summary: HardwareSummary;
  active: boolean;
  busy: boolean;
  run: HardwareRun;
}) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [credentialRefId, setCredentialRefId] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingRequest, setPendingRequest] = useState<string>();
  const claim = summary.reservation;
  const config = summary.item.config;
  const auth = config.auth as JsonObject;
  const savedPassword =
    auth.kind === "password" ? String(auth.credentialRefId) : undefined;
  const available = active && claim?.accessState === "closed";
  useEffect(() => {
    if (
      pendingRequest &&
      state.receipts.some(
        (receipt) =>
          receipt.requestId === pendingRequest && receipt.state !== "running",
      )
    )
      setPendingRequest(undefined);
  }, [pendingRequest, state.receipts]);

  function close() {
    if (saving) return;
    setOpen(false);
    setPassword("");
    setCredentialRefId(undefined);
    setError(undefined);
  }

  async function register() {
    if (!claim || !available || busy || saving) return;
    const reservation = {
      reservationId: claim.reservationId,
      generation: claim.generation,
    };
    setSaving(true);
    setError(undefined);
    try {
      let reference = credentialRefId ?? savedPassword;
      if (password) {
        reference =
          credentialRefId ?? `ssh-registration-${hardwareRequestId()}`;
        setCredentialRefId(reference);
        await saveHardwareSshPassword(reference, password);
        setPassword("");
      }
      const receipt = await run("hardware.ssh.registerKey", {
        ...reservation,
        timeoutMs: 60000,
        ...(reference ? { credentialRefId: reference } : {}),
      });
      if (receipt?.state === "running") setPendingRequest(receipt.requestId);
      setOpen(false);
      setCredentialRefId(undefined);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The registration password could not be saved.",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <ControlButton
        disabled={busy || saving || !available || Boolean(pendingRequest)}
        title={
          active && claim?.accessState !== "closed"
            ? "Close access before registering SSH keys."
            : undefined
        }
        onClick={() => setOpen(true)}
      >
        <KeyRound size={14} />
        {pendingRequest ? "Registering SSH key…" : "Register SSH key…"}
      </ControlButton>
      {open ? (
        <HardwareDialog title="Register SSH key" onClose={close}>
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void register();
            }}
          >
            <p>
              Register keys for{" "}
              <strong>
                {String(config.username)}@{String(config.host)}:
                {String(config.port)}
              </strong>
              .
            </p>
            <p className="hardware-muted">
              {auth.kind === "identity_file"
                ? "Adds the configured identity's public key to the remote user's authorized keys."
                : "Adds all keys from the CloudX host's current SSH agent to the remote user's authorized keys."}{" "}
              This does not change the saved login method.
            </p>
            {savedPassword ? (
              <p className="hardware-muted">
                Uses the saved login password unless you enter a one-time
                password below.
              </p>
            ) : (
              <p className="hardware-muted">
                Enter the remote login password if the current keys cannot log
                in. Leave it blank to use key authentication.
              </p>
            )}
            <label>
              One-time registration password (optional)
              <input
                aria-label="SSH registration password"
                type="password"
                autoComplete="new-password"
                disabled={busy || saving}
                value={password}
                onChange={(event) => {
                  setPassword(event.target.value);
                  setCredentialRefId(undefined);
                  setError(undefined);
                }}
              />
            </label>
            {credentialRefId && !password ? (
              <p className="hardware-muted">
                Registration password saved for this attempt.
              </p>
            ) : null}
            {error ? (
              <p role="alert" className="hardware-banner danger">
                {error}
              </p>
            ) : null}
            {!available ? (
              <p role="alert" className="hardware-banner warning">
                Registration requires your original active reservation with
                closed access.
              </p>
            ) : null}
            <footer className="hardware-form-actions">
              <ControlButton disabled={saving} onClick={close}>
                Cancel registration
              </ControlButton>
              <ControlButton
                tone="primary"
                type="submit"
                disabled={busy || saving || !available}
              >
                {saving ? "Registering…" : "Register key"}
              </ControlButton>
            </footer>
          </form>
        </HardwareDialog>
      ) : null}
    </>
  );
}
