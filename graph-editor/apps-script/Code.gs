const TAB_DEFAULT = 'Graphs';

function doGet(e) {
  const sheetId = e.parameter.sheet;
  const tab = e.parameter.tab || TAB_DEFAULT;
  const row = Number(e.parameter.row);
  const ss = SpreadsheetApp.openById(sheetId);
  const sh = ss.getSheetByName(tab);
  const json = sh.getRange(row, 2).getValue(); // Column B holds JSON
  return _jsonOutput(json);
}

function doPost(e) {
  const body = JSON.parse(e.postData.contents || '{}');
  const { sheet, tab = TAB_DEFAULT, row, json } = body;
  const ss = SpreadsheetApp.openById(sheet);
  const sh = ss.getSheetByName(tab);
  sh.getRange(Number(row), 2).setValue(json);
  sh.getRange(Number(row), 3).setValue(new Date()); // optional updated_at in col C
  return _jsonOutput({ ok: true });
}

function _jsonOutput(obj) {
  const out = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}
