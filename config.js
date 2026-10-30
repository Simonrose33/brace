// The one place to rename the app.
// If you change APP_NAME, also update "name"/"short_name" in manifest.webmanifest
// and the <title> in index.html (see README).
window.APP_CONFIG = {
  APP_NAME: "Brace",

  // Name of the Google Doc created in his Drive for the automatic backup.
  // Only used when the doc is first created; afterwards it is found by its id.
  get DOC_NAME() { return `${this.APP_NAME} journal`; },

  // From Google Cloud Console (see README, "Backup su Google Drive").
  // Leave GOOGLE_CLIENT_ID empty to hide the Drive backup.
  GOOGLE_CLIENT_ID: "",
  // Needed only to link an existing doc by its link (Google's file chooser).
  GOOGLE_API_KEY: "",
  GOOGLE_PROJECT_NUMBER: "",

  // Neutral storage prefix: renaming the app never loses entries. Do not change.
  STORAGE_PREFIX: "gj",
};
