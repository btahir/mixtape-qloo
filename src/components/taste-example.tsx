import Link from "next/link";
import { singular, type Kind } from "@/lib/domain-view";
export type TasteExample = { from: string; to: string; date: string; choices: { kind: Kind; from: string; to: string; changed: boolean }[] };
export function TasteExampleView({ example }: { example?: TasteExample }) {
  if (!example) return null;
  const changed = example.choices.filter((choice) => choice.changed).map((choice) => singular[choice.kind]);
  return <details className="taste-example">
    <summary><span>One different book. {changed.includes("artist") ? "Different music." : "Different choices."}</span><span>See what changed <span aria-hidden="true">＋</span></span></summary>
    <div className="taste-example-body">
      <p className="eyebrow">Saved example · Same nine favourites</p>
      <p className="taste-example-swap">{example.from} <span aria-label="changed to">→</span> <strong>{example.to}</strong></p>
      <ul>{example.choices.map((choice) => <li key={choice.kind}><span>{singular[choice.kind]} · {choice.changed ? "changed" : "stayed"}</span><strong>{choice.changed ? `${choice.from} → ${choice.to}` : choice.to}</strong></li>)}</ul>
      <p className="fine-print">Two saved Qloo rankings of Maya and Leo’s fictional exchange. Only this taste changed; no model ran in this comparison. Different choices do not prove better choices.</p>
      <Link href="/connections">Explore the evidence ↗</Link>
    </div>
  </details>;
}
