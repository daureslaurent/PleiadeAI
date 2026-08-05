import { render, type TemplateScope } from './template';

/**
 * The `condition` node's expression language (flows spec §3).
 *
 * Deliberately tiny and deliberately **not** `eval`/`Function`: an operator-authored string that ran
 * as JavaScript inside the backend would be a remote-code path dressed up as a config field. This
 * parses a fixed grammar and evaluates it directly, so the worst a malformed expression can do is
 * fail validation.
 *
 * ```
 * expr    := or
 * or      := and ( 'or' and )*
 * and     := not ( 'and' not )*
 * not     := 'not' not | primary
 * primary := '(' expr ')' | comparison
 * cmp     := operand [ op operand ]        // a bare operand is a truthiness test
 * op      := == | != | < | <= | > | >= | contains | not contains | matches | startswith | endswith
 * operand := "string" | 'string' | number | true | false | {{ref}} | bare-word
 * ```
 *
 * Operands interpolate first, so `{{writer.text}} contains "approved"` compares the upstream agent's
 * answer. Numeric comparison is used when both sides parse as numbers, string comparison otherwise.
 */

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExprError';
  }
}

type Token =
  | { kind: 'op'; value: string }
  | { kind: 'word'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'lparen' }
  | { kind: 'rparen' };

const OPERATORS = ['==', '!=', '<=', '>=', '<', '>'] as const;
const WORD_OPS = ['contains', 'matches', 'startswith', 'endswith'] as const;

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === '(') {
      tokens.push({ kind: 'lparen' });
      i += 1;
      continue;
    }
    if (ch === ')') {
      tokens.push({ kind: 'rparen' });
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = input.indexOf(ch, i + 1);
      if (end < 0) throw new ExprError(`unterminated string starting at position ${i}`);
      tokens.push({ kind: 'string', value: input.slice(i + 1, end) });
      i = end + 1;
      continue;
    }
    const twoChar = input.slice(i, i + 2);
    const op = OPERATORS.find((o) => (o.length === 2 ? o === twoChar : o === ch));
    if (op) {
      tokens.push({ kind: 'op', value: op });
      i += op.length;
      continue;
    }
    // A bare word: an identifier, a number, a keyword, or a `{{ref}}` (braces are word characters
    // here so a reference survives tokenization intact and is interpolated at evaluation time).
    const match = /^(\{\{[^}]*\}\}|[^\s()"'<>=!]+)/.exec(input.slice(i));
    if (!match) throw new ExprError(`unexpected character "${ch}" at position ${i}`);
    tokens.push({ kind: 'word', value: match[1]! });
    i += match[1]!.length;
  }
  return tokens;
}

type Node =
  | { kind: 'or' | 'and'; left: Node; right: Node }
  | { kind: 'not'; operand: Node }
  | { kind: 'cmp'; op: string | null; left: string; right: string | null; negated?: boolean };

class Parser {
  private pos = 0;

  constructor(private readonly tokens: Token[]) {}

  parse(): Node {
    const node = this.parseOr();
    if (this.pos < this.tokens.length) throw new ExprError('unexpected trailing input');
    return node;
  }

  private peekWord(): string | null {
    const token = this.tokens[this.pos];
    return token?.kind === 'word' ? token.value.toLowerCase() : null;
  }

  private parseOr(): Node {
    let left = this.parseAnd();
    while (this.peekWord() === 'or') {
      this.pos += 1;
      left = { kind: 'or', left, right: this.parseAnd() };
    }
    return left;
  }

  private parseAnd(): Node {
    let left = this.parseNot();
    while (this.peekWord() === 'and') {
      this.pos += 1;
      left = { kind: 'and', left, right: this.parseNot() };
    }
    return left;
  }

  private parseNot(): Node {
    if (this.peekWord() === 'not') {
      this.pos += 1;
      return { kind: 'not', operand: this.parseNot() };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Node {
    const token = this.tokens[this.pos];
    if (!token) throw new ExprError('unexpected end of expression');
    if (token.kind === 'lparen') {
      this.pos += 1;
      const inner = this.parseOr();
      if (this.tokens[this.pos]?.kind !== 'rparen') throw new ExprError('missing closing parenthesis');
      this.pos += 1;
      return inner;
    }
    return this.parseComparison();
  }

  private parseComparison(): Node {
    const left = this.readOperand();

    // `x not contains y` — the only place `not` is infix.
    let negated = false;
    if (this.peekWord() === 'not' && this.tokens[this.pos + 1]?.kind === 'word') {
      const next = (this.tokens[this.pos + 1] as { value: string }).value.toLowerCase();
      if ((WORD_OPS as readonly string[]).includes(next)) {
        negated = true;
        this.pos += 1;
      }
    }

    const token = this.tokens[this.pos];
    if (token?.kind === 'op') {
      this.pos += 1;
      return { kind: 'cmp', op: token.value, left, right: this.readOperand(), negated };
    }
    const word = this.peekWord();
    if (word && (WORD_OPS as readonly string[]).includes(word)) {
      this.pos += 1;
      return { kind: 'cmp', op: word, left, right: this.readOperand(), negated };
    }
    if (negated) throw new ExprError('"not" must be followed by an operator or an expression');
    return { kind: 'cmp', op: null, left, right: null };
  }

  private readOperand(): string {
    const token = this.tokens[this.pos];
    if (!token || token.kind === 'lparen' || token.kind === 'rparen' || token.kind === 'op') {
      throw new ExprError('expected a value');
    }
    this.pos += 1;
    return token.value;
  }
}

/** Parse an expression, throwing `ExprError` on anything malformed. Used by graph validation. */
export function parseExpr(input: string): Node {
  const trimmed = input.trim();
  if (!trimmed) throw new ExprError('the condition is empty');
  return new Parser(tokenize(trimmed)).parse();
}

/** Empty / "false" / "0" / "no" are false; everything else with content is true. */
function truthy(value: string): boolean {
  const v = value.trim().toLowerCase();
  return v !== '' && v !== 'false' && v !== '0' && v !== 'no' && v !== 'null' && v !== 'undefined';
}

function numeric(a: string, b: string): [number, number] | null {
  const x = Number(a);
  const y = Number(b);
  if (!Number.isFinite(x) || !Number.isFinite(y) || a.trim() === '' || b.trim() === '') return null;
  return [x, y];
}

function compare(op: string, rawLeft: string, rawRight: string): boolean {
  const left = rawLeft.trim();
  const right = rawRight.trim();
  const nums = numeric(left, right);

  switch (op) {
    case '==':
      return nums ? nums[0] === nums[1] : left.toLowerCase() === right.toLowerCase();
    case '!=':
      return nums ? nums[0] !== nums[1] : left.toLowerCase() !== right.toLowerCase();
    case '<':
      return nums ? nums[0] < nums[1] : left < right;
    case '<=':
      return nums ? nums[0] <= nums[1] : left <= right;
    case '>':
      return nums ? nums[0] > nums[1] : left > right;
    case '>=':
      return nums ? nums[0] >= nums[1] : left >= right;
    case 'contains':
      return left.toLowerCase().includes(right.toLowerCase());
    case 'startswith':
      return left.toLowerCase().startsWith(right.toLowerCase());
    case 'endswith':
      return left.toLowerCase().endsWith(right.toLowerCase());
    case 'matches':
      try {
        return new RegExp(right, 'i').test(left);
      } catch {
        throw new ExprError(`"${right}" is not a valid regular expression`);
      }
    default:
      throw new ExprError(`unknown operator "${op}"`);
  }
}

function evalNode(node: Node, scope: TemplateScope): boolean {
  switch (node.kind) {
    case 'or':
      return evalNode(node.left, scope) || evalNode(node.right, scope);
    case 'and':
      return evalNode(node.left, scope) && evalNode(node.right, scope);
    case 'not':
      return !evalNode(node.operand, scope);
    case 'cmp': {
      const left = render(node.left, scope);
      if (node.op === null) return truthy(left);
      const result = compare(node.op, left, render(node.right ?? '', scope));
      return node.negated ? !result : result;
    }
  }
}

/** Evaluate an expression against a scope of completed node outputs. */
export function evaluate(input: string, scope: TemplateScope): boolean {
  return evalNode(parseExpr(input), scope);
}
