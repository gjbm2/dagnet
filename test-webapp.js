/**
 * Minimal test script for Google Apps Script web app
 */

function doGet(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ 
      success: true, 
      message: "doGet is working!",
      parameters: e.parameter || {}
    }))
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  return ContentService
    .createTextOutput(JSON.stringify({ 
      success: true, 
      message: "doPost is working!",
      data: e.postData ? e.postData.contents : "no data"
    }))
    .setMimeType(ContentService.MimeType.JSON);
}
