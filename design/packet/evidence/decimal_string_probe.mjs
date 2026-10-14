#!/usr/bin/env node
// decimal-string probe — I1 shared full-string algorithm (Node side).
// Implements the DECIMAL_STRING char-scan algorithm per spec v0.10 §I1.
// No regex; control chars built via String.fromCharCode (no escape sequences in source).
"use strict";

const LF = String.fromCharCode(10);
const CR = String.fromCharCode(13);
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);
const NBSP = String.fromCharCode(0xA0);

function decimalString(s) {
  if (typeof s !== "string") return false;
  const n = s.length;
  if (n === 0) return false;
  let i = 0;
  let neg = false;
  if (s[0] === "-") {
    neg = true;
    i = 1;
    if (i >= n) return false;
  }
  if (s[i] === "0") {
    i += 1;
    if (i < n && s[i] >= "0" && s[i] <= "9") return false;
  } else if (s[i] >= "1" && s[i] <= "9") {
    i += 1;
    while (i < n && s[i] >= "0" && s[i] <= "9") i += 1;
  } else {
    return false;
  }
  if (i === n) {
    if (neg && s.slice(1, i) === "0") return false;
    return true;
  }
  if (s[i] === ".") {
    i += 1;
    if (i >= n) return false;
    let j = i;
    while (j < n && s[j] >= "0" && s[j] <= "9") j += 1;
    if (j === i) return false;
    if (!(s[j - 1] >= "1" && s[j - 1] <= "9")) return false;
    i = j;
  }
  if (i === n) return true;
  return false;
}

const CASES = [
  ["0", true],
  ["12", true],
  ["-12", true],
  ["0.5", true],
  ["-0.5", true],
  ["12.34", true],
  ["10.01", true],
  ["0.001", true],
  ["0.0001", true],
  ["-0.0001", true],
  ["9999999999999", true],
  ["-0", false],
  ["0.0", false],
  ["1.0", false],
  ["1.00", false],
  ["1e3", false],
  ["00.1", false],
  ["+1", false],
  ["1.", false],
  ["01.2", false],
  ["0" + LF, false],
  ["0" + CR, false],
  ["0" + CR + LF, false],
  ["0" + LS, false],
  ["0" + PS, false],
  ["-0.0", false],
  ["", false],
  [" 0", false],
  ["0 ", false],
  ["1e0", false],
  [".5", false],
  ["-.5", false],
  ["000", false],
  ["9.", false],
  ["0" + NBSP, false],
  ["-", false],
  ["--", false],
  ["-.", false],
];

function main() {
  let fails = 0;
  for (const [label, want] of CASES) {
    const got = decimalString(label);
    const ok = got === want;
    if (!ok) fails += 1;
    const shown = label.split(LF).join("<LF>").split(CR).join("<CR>").split(LS).join("<LS>").split(PS).join("<PS>").split(NBSP).join("<NBSP>");
    console.log(`JS | ${(shown || "<empty>").padEnd(12)} | want=${String(want).padEnd(5)} got=${String(got).padEnd(5)} ${ok ? "OK" : "FAIL"}`);
  }
  console.log(`JS_SUMMARY: cases=${CASES.length} fails=${fails} ${fails === 0 ? "ALL_PASS" : "HAS_FAILURES"}`);
  return fails === 0 ? 0 : 1;
}

process.exit(main());
