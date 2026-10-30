export function requestLogin(onSuccess?: () => void) {
  window.dispatchEvent(new CustomEvent("opw:request-login", { detail: { onSuccess } }));
}

export function allowPaidAction(): boolean {
  if (localStorage.getItem("opw_access_token")) return true;
  requestLogin();
  return false;
}
