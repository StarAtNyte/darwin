// A public run should never sit on a finished story. Once one family holds `share` of the living agents for `hold`
// rounds in a row, the run has been decided: the server notes who took over and starts a new run.
export type Takeover = { founder: string; since: number; tick: number; share: number };

export class EpochWatch {
  private since: number | null = null;
  private founder: string | null = null;

  constructor(readonly share = 0.9, readonly hold = 100) {}

  get enabled() {
    return this.hold > 0;
  }

  reset() {
    this.since = this.founder = null;
  }

  /** Feed one round's metrics. Returns the takeover once the same family has held the line for `hold` rounds. */
  observe(tick: number, lineages: Record<string, { n: number }>): Takeover | null {
    if (!this.enabled) return null;
    const total = Object.values(lineages).reduce((s, l) => s + l.n, 0);
    let top: string | null = null, n = 0;
    for (const [f, l] of Object.entries(lineages)) if (l.n > n) (top = f), (n = l.n);
    const share = total ? n / total : 0;
    if (!top || share < this.share) {
      this.reset();
      return null;
    }
    if (top !== this.founder) (this.founder = top), (this.since = tick);
    if (tick - this.since! + 1 < this.hold) return null;
    const t = { founder: top, since: this.since!, tick, share };
    this.reset();
    return t;
  }
}
