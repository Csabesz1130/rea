export function openEditor(endpoint) {
  const dialog = document.createElement("dialog");
  dialog.textContent = `Editing notes from ${endpoint}`;
  document.body.append(dialog);
  dialog.showModal();
}
