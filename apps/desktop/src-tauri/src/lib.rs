// Native shell only. It exposes no custom commands yet: the UI talks to the local API over HTTP,
// and anything the frontend can call here must be added explicitly with a matching capability.
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
