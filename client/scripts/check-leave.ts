/**
 * `npm run check:leave` — Leave and Esc in the plan editor and the confirm
 * view ask first when work would be lost; unchanged leaves at once.
 * Headless (no browser, no Meta calls).
 *
 * - unchanged (plan matches the editor's opening snapshot, no photo
 *   draft): Leave/Esc call `cancelEditor` with no dialog;
 * - changed plan or open photo draft: Leave/Esc open `leave-confirm-dialog`
 *   ("Leave and lose your changes?", plus " Your photos will be deleted."
 *   for a photo-built draft) with "Keep editing" (focused default, Esc
 *   keeps editing) and "Discard and leave";
 * - Keep editing only closes the dialog (the edit stays); Discard and
 *   leave calls `cancelEditor` (restores the base, drops stored photos).
 *
 * Prints PASS or FAIL per check and exits non-zero on any FAIL.
 */

/* global console, process */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCARD_AND_LEAVE,
  KEEP_EDITING,
  LEAVE_CONFIRM_MESSAGE,
  LEAVE_CONFIRM_PHOTOS,
} from "../src/copy.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (rel: string): string => readFileSync(join(root, "src", rel), "utf8");

let failures = 0;

function check(name: string, pass: boolean, detail?: string): void {
  if (pass) {
    console.log(`PASS ${name}`);
  } else {
    failures += 1;
    console.log(`FAIL ${name}${detail === undefined ? "" : ` — ${detail}`}`);
  }
}

function methodBody(source: string, name: string): string {
  const start = source.indexOf(name);
  if (start < 0) return "";
  const next = source.indexOf("private ", start + name.length);
  return next < 0 ? source.slice(start) : source.slice(start, next);
}

check(
  "question reads Leave and lose your changes?",
  LEAVE_CONFIRM_MESSAGE === "Leave and lose your changes?",
);
check(
  "photo line adds the photos sentence",
  LEAVE_CONFIRM_PHOTOS === " Your photos will be deleted.",
);
check("keep reads Keep editing", KEEP_EDITING === "Keep editing");
check("discard reads Discard and leave", DISCARD_AND_LEAVE === "Discard and leave");

const main = src("main.ts");
const editor = src("editor/editor.ts");
const confirm = src("editor/photo-confirm.ts");

check(
  "editor Leave asks through the confirm path",
  main.includes("onCancel: () => this.requestCancelEditor()"),
  "main.ts",
);
check(
  "confirm view Leave asks through the same path",
  editor.includes("onLeave: () => this.callbacks.onCancel()") &&
    confirm.includes("this.actions.onLeave()"),
  "editor.ts + photo-confirm.ts",
);
check(
  "Esc in the editor asks through the confirm path",
  methodBody(main, "private bindKeys").includes("this.requestCancelEditor()"),
  "main.ts bindKeys",
);

const request = methodBody(main, "private requestCancelEditor");
const dirty = methodBody(main, "private editorHasChanges");
check(
  "dirty check sees an open photo draft",
  dirty.includes("this.photoDraft !== null"),
  "editorHasChanges",
);
check(
  "dirty check compares against the opening snapshot",
  dirty.includes("this.editorBase") && dirty.includes("this.editorStore?.room"),
  "editorHasChanges",
);
check(
  "unchanged leaves at once with no dialog",
  request.includes("if (!this.editorHasChanges())") && request.includes("this.cancelEditor()"),
  "requestCancelEditor",
);
check(
  "changed opens one leave-confirm dialog",
  request.includes('id = "leave-confirm-dialog"') && request.includes("dialog.showModal()"),
  "requestCancelEditor",
);
check(
  "dialog message renders from the copy module",
  request.includes("LEAVE_CONFIRM_MESSAGE") && request.includes("LEAVE_CONFIRM_PHOTOS"),
  "requestCancelEditor",
);
check(
  "dialog buttons render from the copy module",
  request.includes("KEEP_EDITING") && request.includes("DISCARD_AND_LEAVE"),
  "requestCancelEditor",
);
check(
  "Keep editing is the focused default",
  request.includes("keep.focus()") && request.indexOf("row.append(keep, discard)") >= 0,
  "requestCancelEditor",
);
check(
  "Keep editing only closes the dialog (the edit stays)",
  request.includes("previousFocus?.focus()") &&
    !/keep\.addEventListener\("click", \(\) => \{[^}]*cancelEditor/s.test(request),
  "requestCancelEditor",
);
check(
  "Discard and leave calls cancelEditor (restores the base)",
  /discard\.addEventListener\("click", \(\) => \{[^}]*this\.cancelEditor\(\)/s.test(request),
  "requestCancelEditor",
);
check(
  "Esc drops the dialog so a later Leave asks again",
  request.includes('dialog.addEventListener("close"'),
  "requestCancelEditor",
);

for (const file of ["main.ts", "editor/editor.ts", "editor/photo-confirm.ts"] as const) {
  const code = src(file)
    .split("\n")
    .filter((line) => {
      const trimmed = line.trim();
      return !trimmed.startsWith("//") && !trimmed.startsWith("*") && !trimmed.startsWith("/*");
    })
    .join("\n");
  check(
    `${file} carries no leave-confirm literal`,
    !code.includes("Leave and lose your changes?") &&
      !code.includes("Your photos will be deleted.") &&
      !code.includes("Discard and leave"),
    file,
  );
}

if (failures > 0) process.exit(1);
console.log("leave confirm ok");
