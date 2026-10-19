// Secret redaction for saved evidence and diagnostics (plan Non-Functional Baseline, task 2.3).
import { redactMemorySecrets } from "@oh-my-pi/pi-coding-agent/memory-backend/redact";

const MARKER = "[REDACTED]";
// A token: ≥ 16 token chars including a digit, so "Bearer authentication" stays prose.
const BEARER = /\b(Bearer\s+)(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/g;
// PEM private keys. A block cut by truncation (BEGIN + key body to the segment end, or key
// body + END from the segment start) is redacted only when the text beside the marker looks
// like a key body (headers and base64), so prose that mentions a marker survives.
const BODY = String.raw`(?:\r?\n[A-Za-z-]+: [^\n]*)*[A-Za-z0-9+/=\r\n]*`;
const LABEL = "[A-Z0-9 ]*PRIVATE KEY";
const PEM_BLOCK = new RegExp(`-----BEGIN ${LABEL}-----(?:[\\s\\S]*?-----END ${LABEL}-----|${BODY}$)`, "g");
const PEM_ORPHAN_END = new RegExp(`^${BODY}-----END ${LABEL}-----`);

/** `redactMemorySecrets` plus `Bearer <token>` and PEM private keys; every replacement is `[REDACTED]`. */
export function redact(text: string): string {
	const pemFree = text.replace(PEM_BLOCK, MARKER).replace(PEM_ORPHAN_END, MARKER);
	return redactMemorySecrets(pemFree).replace(BEARER, `$1${MARKER}`);
}
