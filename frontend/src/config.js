function getConfig(name, defaultValue = null) {
  if (window.ENV !== undefined) {
    return window.ENV[name] || defaultValue;
  }
  return import.meta.env[name] || defaultValue;
}
export function getBackendUrl() {
  return getConfig("REACT_APP_BACKEND_URL") || getConfig("VITE_BACKEND_URL");
}
export function getHoursCloseTicketsAuto() {
  return getConfig("VITE_HOURS_CLOSE_TICKETS_AUTO") || getConfig("REACT_APP_HOURS_CLOSE_TICKETS_AUTO");
}
