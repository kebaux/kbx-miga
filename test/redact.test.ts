import { expect, test } from "bun:test";
import { redact } from "../src/redact";

test("AWS key, token=sk-…, Bearer token and PEM block are replaced; ordinary text unchanged", () => {
	const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEAx1\nabc==\n-----END RSA PRIVATE KEY-----";
	const input = [
		"aws AKIAIOSFODNN7EXAMPLE",
		"token=sk-abcdefghijklmnop1234",
		"Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghij",
		`key file:\n${pem}\nafter`,
	].join("\n");
	const out = redact(input);
	expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
	expect(out).not.toContain("sk-abcdefghijklmnop1234");
	expect(out).not.toContain("eyJhbGciOiJIUzI1NiJ9");
	expect(out).not.toContain("MIIEowIBAAKCAQEAx1");
	expect(out).toContain("Authorization: Bearer [REDACTED]");
	expect(out).toContain("key file:\n[REDACTED]\nafter");

	const ordinary = [
		"The worker ran twice because the ack happens before the write in src/worker/loop.ts.",
		"The API uses the Bearer authentication scheme; send Bearer credentials in the header.",
		"PEM files end with -----END PRIVATE KEY----- and the parser checks it.",
		"Check the header: if (pem.startsWith('-----BEGIN PRIVATE KEY-----')) return parsePkcs8(pem);",
	];
	for (const text of ordinary) expect(redact(text)).toBe(text);
});

test("a PEM block cut by truncation is still redacted", () => {
	expect(redact("x\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq")).toBe("x\n[REDACTED]");
	expect(redact("kq9w0BAQEFAASC\n-----END PRIVATE KEY-----\ny")).toBe("[REDACTED]\ny");
});
