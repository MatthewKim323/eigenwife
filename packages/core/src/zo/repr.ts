/**
 * Zo's app tools answer with Python reprs, not JSON:
 *
 *   exports={'$summary': '...'} os=[] ret={'id': 'abc', 'self': True} stash_id=None t={...}
 *   summary="..." places=[MapPlace(title='X - Google Maps', uri='https://...', rating=None)]
 *
 * This is a small tolerant parser for that literal subset: dicts, lists,
 * tuples, quoted strings (single, double, with escapes), numbers,
 * True/False/None, and Name(key=value, ...) calls (parsed to objects with a
 * `__type` field). Anything it cannot read becomes undefined, never a throw.
 */

type Py = unknown;

class Reader {
  i = 0;
  constructor(readonly s: string) {}

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
  }

  peek(): string {
    return this.s[this.i] ?? "";
  }

  value(): Py {
    this.ws();
    const c = this.peek();
    if (c === "{") return this.dict();
    if (c === "[") return this.seq("[", "]");
    if (c === "(") return this.seq("(", ")");
    if (c === "'" || c === '"') return this.str();
    if (/[-+0-9.]/.test(c)) return this.num();
    if (/[A-Za-z_]/.test(c)) return this.word();
    throw new Error(`unexpected ${JSON.stringify(c)} at ${this.i}`);
  }

  str(): string {
    const q = this.s[this.i]!;
    // Triple quotes are rare in reprs but cheap to support.
    const triple = this.s.startsWith(q.repeat(3), this.i);
    this.i += triple ? 3 : 1;
    let out = "";
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (triple ? this.s.startsWith(q.repeat(3), this.i) : c === q) {
        this.i += triple ? 3 : 1;
        return out;
      }
      if (c === "\\") {
        const n = this.s[this.i + 1] ?? "";
        this.i += 2;
        if (n === "n") out += "\n";
        else if (n === "t") out += "\t";
        else if (n === "r") out += "\r";
        else if (n === "0") out += "\0";
        else if (n === "x") {
          out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16));
          this.i += 2;
        } else if (n === "u") {
          out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16));
          this.i += 4;
        } else if (n === "U") {
          out += String.fromCodePoint(parseInt(this.s.slice(this.i, this.i + 8), 16));
          this.i += 8;
        } else out += n;
        continue;
      }
      out += c;
      this.i++;
    }
    throw new Error("unterminated string");
  }

  num(): number {
    const m = this.s.slice(this.i).match(/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?/i);
    if (!m) throw new Error(`bad number at ${this.i}`);
    this.i += m[0].length;
    return Number(m[0]);
  }

  ident(): string {
    const m = this.s.slice(this.i).match(/^[A-Za-z_][A-Za-z0-9_.]*/);
    if (!m) throw new Error(`bad name at ${this.i}`);
    this.i += m[0].length;
    return m[0];
  }

  word(): Py {
    const name = this.ident();
    if (name === "True") return true;
    if (name === "False") return false;
    if (name === "None") return null;
    if (name === "nan" || name === "inf") return null;
    this.ws();
    if (this.peek() === "(") return this.call(name);
    return name;
  }

  call(name: string): Record<string, Py> {
    this.i++; // (
    const out: Record<string, Py> = { __type: name };
    const args: Py[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === ")") {
        this.i++;
        break;
      }
      const save = this.i;
      const m = this.s.slice(this.i).match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)/);
      if (m) {
        this.i += m[0].length;
        out[m[1]!] = this.value();
      } else {
        this.i = save;
        args.push(this.value());
      }
      this.ws();
      if (this.peek() === ",") this.i++;
    }
    if (args.length) out.__args = args;
    return out;
  }

  dict(): Record<string, Py> {
    this.i++;
    const out: Record<string, Py> = {};
    for (;;) {
      this.ws();
      if (this.peek() === "}") {
        this.i++;
        return out;
      }
      const k = this.value();
      this.ws();
      if (this.peek() !== ":") throw new Error(`expected : at ${this.i}`);
      this.i++;
      out[String(k)] = this.value();
      this.ws();
      if (this.peek() === ",") this.i++;
    }
  }

  seq(open: string, close: string): Py[] {
    this.i++;
    const out: Py[] = [];
    for (;;) {
      this.ws();
      if (this.peek() === close) {
        this.i++;
        return out;
      }
      out.push(this.value());
      this.ws();
      if (this.peek() === ",") this.i++;
    }
  }
}

/** One Python literal. undefined when it cannot be read. */
export function parsePy(s: string): unknown {
  try {
    return new Reader(s.trim()).value();
  } catch {
    return undefined;
  }
}

/**
 * `a=<lit> b=<lit> ...` (space separated top-level assignments) -> object.
 * Stops at the first thing it cannot read and returns what it has.
 */
export function parseKwargs(s: string): Record<string, unknown> {
  const r = new Reader(s);
  const out: Record<string, unknown> = {};
  for (;;) {
    r.ws();
    const m = r.s.slice(r.i).match(/^([A-Za-z_$][A-Za-z0-9_$]*)=/);
    if (!m) break;
    r.i += m[0].length;
    try {
      out[m[1]!] = r.value();
    } catch {
      break;
    }
  }
  return out;
}
