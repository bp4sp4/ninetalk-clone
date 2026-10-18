export const NAME_TOKEN = "{이름}";

/** Picks the honorific or casual version for a recipient and fills in {이름}. */
export function renderMessage(
  name: string,
  senderType: "Honorific" | "TalkDown",
  honorificText: string,
  talkdownText: string,
): string {
  const template = senderType === "TalkDown" && talkdownText.trim() ? talkdownText : honorificText;
  return template.replaceAll(NAME_TOKEN, name);
}

const isHeader = (name: string) => name === "이름" || name.toLowerCase() === "name";

const clean = (name: string) => name.trim().replace(/^"(.*)"$/, "$1").trim();

/** Pasted text: one name per line or comma. */
export function parseNames(input: string): string[] {
  return input
    .split(/[\r\n,]+/)
    .map(clean)
    .filter((name) => name.length > 0 && !isHeader(name));
}

/** CSV or spreadsheet export: the first column of each row is the name. */
export function parseCsvNames(input: string): string[] {
  return input
    .replace(/^﻿/, "")
    .split(/\r?\n/)
    .map((line) => clean(line.split(/[,\t]/)[0] ?? ""))
    .filter((name) => name.length > 0 && !isHeader(name));
}
