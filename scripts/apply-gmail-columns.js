// Run in Thunderbird's Error Console with the target folder open.
// Only changes that folder's column visibility/order; preserves messages and tags.
(async () => {
  const pane = Services.wm.getMostRecentWindow("mail:3pane")
    .document.getElementById("tabmail").currentAbout3Pane;
  if (!pane?.gFolder || pane.gViewWrapper.isSynthetic) throw new Error("Open a regular mail folder first.");
  const path = PathUtils.join(PathUtils.profileDir, "gmail-skin-columns.json");
  const columns = pane.threadPane.columns;
  if (!(await IOUtils.exists(path))) {
    await IOUtils.writeJSON(path, {
      folderURI: pane.gFolder.URI,
      columns: Object.fromEntries(columns.map(c => [c.id, {visible: !c.hidden, ordinal: c.ordinal}]))
    });
  } else if ((await IOUtils.readJSON(path)).folderURI !== pane.gFolder.URI) {
    throw new Error("Backup belongs to another folder; preserve it and choose another backup path.");
  }
  for (const column of columns) {
    if (["correspondentCol", "betweenColumn"].includes(column.id)) column.hidden = true;
    if (["senderCol", "subjectCol", "attachmentCol", "dateCol"].includes(column.id)) column.hidden = false;
  }
  const order = ["selectCol", "threadCol", "flaggedCol",
    "unreadButtonColHeader", "junkStatusCol", "senderCol", "subjectCol", "attachmentCol", "dateCol"];
  const rank = id => order.includes(id) ? order.indexOf(id) : order.length;
  columns.sort((a,b) => rank(a.id) - rank(b.id));
  columns.forEach((c,i) => { c.ordinal = i + 1; });
  pane.threadPane.updateColumns();
  pane.threadTree.reset();
  pane.threadPane.persistColumnStates();
  const { XULStoreUtils } = ChromeUtils.importESModule("resource:///modules/XULStoreUtils.sys.mjs");
  const backup = await IOUtils.readJSON(path);
  if (!("widths" in backup)) {
    backup.widths = XULStoreUtils.getValue("messenger", "columns", "widths") || "";
    await IOUtils.writeJSON(path, backup);
  }
  const available = pane.threadTree.clientWidth;
  const widths = { senderCol: 220, subjectCol: Math.max(260, available - 220 - 150 - 130) };
  for (const [column, width] of Object.entries(widths)) {
    pane.document.getElementById(column).style.setProperty(`--${column}Splitter-width`, `${width}px`);
    pane.threadPane.treeTable.setColumnsWidths("messenger", {detail:{column, splitter:{width}}});
  }
  console.log("GMAIL-COLUMNS: saved previous layout; From, inline labels/subject, attachment, then Date.");
})().catch(console.error);
