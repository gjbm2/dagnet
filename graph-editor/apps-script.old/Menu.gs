function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Graph Editor')
    .addItem('Open Visual Editor', 'openEditor')
    .addToUi();
}

function openEditor() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Row number for this graph?', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const row = Number(resp.getResponseText());
  const sheetId = SpreadsheetApp.getActive().getId();
  const tab = SpreadsheetApp.getActiveSheet().getName();
  const editorUrl = 'https://graph-editor-yourname.vercel.app/'; // replace after deploy
  const full = `${editorUrl}?sheet=${sheetId}&tab=${encodeURIComponent(tab)}&row=${row}`;
  const html = HtmlService.createHtmlOutput(`<a href="${full}" target="_blank">Open Editor</a>`).setWidth(300).setHeight(80);
  ui.showModelessDialog(html, 'Visual Editor');
}
