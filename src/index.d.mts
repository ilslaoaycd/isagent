export type SignalName =
  | "overlay-host" | "overlay-active" | "overlay-activity" | "legacy-marker" | "tab-icon" | "form-input"
  | "agent-marker" | "automation-globals" | "synthetic-typing" | "teleport-click" | "synthetic-fill"
  | "insert-text" | "programmatic-click" | "unexplained-value" | "centered-clicks";

export type FillMethod =
  | "form_input" | "synthetic-typing" | "insert-text" | "programmatic-click" | "synthetic-event" | "no-user-input";

export interface Signal {
  name: SignalName;
  /** 0..1: how strongly this signal alone indicates an agent */
  weight: number;
  /** Agent this signal identifies ("claude-in-chrome", "chatgpt-agent", ...) or null for generic automation */
  agent: string | null;
  description: string;
  count: number;
  first: number;
  last: number;
  details: Array<Record<string, unknown>>;
}

export interface FieldFill {
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  /** e.g. `input#email[name="email"]`, with ` in <x-host>` / ` in iframe` when relevant */
  field: string;
  method: FillMethod;
  value: string | boolean;
  time: number;
}

export interface Report {
  version: string;
  verdict: "agent" | "suspected" | "none";
  detected: boolean;
  /** Most likely agent, "unknown" for unattributed automation, or null */
  agent: string | null;
  /** Claude's on-page Stop button / status tag is showing right now */
  active: boolean;
  /** Combined likelihood that any agent is driving the page */
  score: number;
  /** Combined likelihood for Claude in Chrome specifically */
  claude: number;
  agents: Record<string, number>;
  signals: Signal[];
  filledFields: FieldFill[];
}

export interface Summary {
  v: string;
  verdict: Report["verdict"];
  agent: string | null;
  active: boolean;
  score: number;
  claude: number;
  /** "name:count" */
  signals: string[];
  /** "field:method" */
  fields: string[];
}

export interface Options {
  /** Score at which `detected` becomes true. Default 0.85 */
  threshold?: number;
  overlay?: boolean;
  markers?: boolean;
  favicon?: boolean;
  forms?: boolean;
  keyboard?: boolean;
  mouse?: boolean;
  environment?: boolean;
  /** Also watch same-origin iframes. Default true */
  frames?: boolean;
  probeShadowRoot?: boolean;
  sentinel?: boolean;
  activeProbeMs?: number;
  typingStreak?: number;
  maxKeyHoldMs?: number;
  maxKeyGapMs?: number;
  maxClickHoldMs?: number;
  /** Adds this field, holding JSON of summary(form), to every FormData built from a form */
  formField?: string | null;
  onSignal?: (signal: Signal, report: Report) => void;
  onDetect?: (report: Report) => void;
  onFieldFill?: (fill: FieldFill) => void;
  onActiveChange?: (active: boolean) => void;
  debug?: boolean;
}

export declare class Detector {
  constructor(options?: Options);
  readonly options: Required<Options>;
  start(): this;
  stop(): this;
  reset(): this;
  audit(scope?: ParentNode | HTMLFormElement): this;
  report(): Report;
  summary(scope?: ParentNode | HTMLFormElement): Summary;
  agentFill(el: Element): FieldFill | null;
}

export declare const VERSION: string;
export declare const SIGNALS: Record<SignalName, { weight: number; agent: string | null; description: string }>;
export declare function start(options?: Options): Detector;
/** true when an AI browser agent is (or was) operating on this page */
export declare function isAgent(detector?: Detector): boolean;
export declare function isClaudeOverlayHost(el: Element, probe?: boolean): boolean;
export declare function isClaudeTabIcon(href: string | null): boolean;
export declare function automationArtifacts(win: Window): string[];

declare const isagent: {
  VERSION: typeof VERSION;
  SIGNALS: typeof SIGNALS;
  Detector: typeof Detector;
  start: typeof start;
  isAgent: typeof isAgent;
  isClaudeOverlayHost: typeof isClaudeOverlayHost;
  isClaudeTabIcon: typeof isClaudeTabIcon;
  automationArtifacts: typeof automationArtifacts;
};
export default isagent;

declare global {
  interface WindowEventMap {
    "isagent:signal": CustomEvent<{ signal: Signal; report: Report }>;
    "isagent:detect": CustomEvent<{ report: Report }>;
    "isagent:fill": CustomEvent<FieldFill>;
    "isagent:active": CustomEvent<{ active: boolean }>;
  }
}
