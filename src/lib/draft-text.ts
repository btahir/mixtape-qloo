import type { Draft } from "./domain";
export type Words = Partial<Pick<Draft, "sender" | "recipient" | "introduction">> & { notes?: Record<string, string> };
export function changedWords(base: Draft, edited: Draft): Words {
  const words: Words = {};
  for (const key of ["sender", "recipient", "introduction"] as const)
    if (base[key] !== edited[key]) words[key] = edited[key];
  const notes = Object.fromEntries(edited.shelf.filter((entry) =>
    base.shelf.find((e) => e.entity.id === entry.entity.id)?.note !== entry.note,
  ).map((entry) => [entry.entity.id, entry.note]));
  if (Object.keys(notes).length) words.notes = notes;
  return words;
}
export function applyWords(draft: Draft, words: Words): Draft {
  const { notes, ...fields } = words;
  return { ...draft, ...fields, shelf: draft.shelf.map((entry) => ({
    ...entry, note: notes?.[entry.entity.id] ?? entry.note,
  })) };
}
export function wordConflicts(base: Draft, latest: Draft, words: Words) {
  const conflicts: string[] = [];
  for (const [key, label] of [["sender", "From"], ["recipient", "To"], ["introduction", "A line from you"]] as const)
    if (words[key] !== undefined && latest[key] !== base[key] && latest[key] !== words[key]) conflicts.push(label);
  for (const entry of latest.shelf)
    if (words.notes?.[entry.entity.id] !== undefined &&
      entry.note !== base.shelf.find((e) => e.entity.id === entry.entity.id)?.note &&
      entry.note !== words.notes[entry.entity.id]) conflicts.push(`Note for ${entry.entity.name}`);
  return conflicts;
}
