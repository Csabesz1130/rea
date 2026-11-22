import { sha256 } from "./source.mjs";

const MAX_ISSUES = 256;
const PREVIEW = 256;

/** Ordered findings with a severity, a stable code and the file offset they cite. */
export class Issues {
  constructor() {
    this.list = [];
    this.omitted = 0;
  }
  add(severity, code, message, at, tensor) {
    if (this.list.length >= MAX_ISSUES) {
      this.omitted++;
      return;
    }
    this.list.push({
      severity,
      code,
      message,
      ...(at !== undefined ? { at } : {}),
      ...(tensor !== undefined ? { tensor } : {}),
    });
  }
  error(code, message, at, tensor) {
    this.add("error", code, message, at, tensor);
  }
  warn(code, message, at, tensor) {
    this.add("warning", code, message, at, tensor);
  }
  notice(code, message, at, tensor) {
    this.add("notice", code, message, at, tensor);
  }
  get valid() {
    return !this.list.some((i) => i.severity === "error");
  }
  attach(report) {
    report.valid = this.valid;
    report.issues = this.list;
    if (this.omitted) report.issues_omitted = this.omitted;
    return report;
  }
}

/** A metadata string as reported: short values verbatim, long ones by digest. */
export function metadataValue(text) {
  if (text.length <= PREVIEW) return text;
  return {
    preview: text.slice(0, PREVIEW),
    length: text.length,
    sha256: sha256(Buffer.from(text, "utf8")),
    truncated: true,
  };
}
