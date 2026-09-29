// jsdom does not implement scrolling; the router calls it after each navigation.
// Node-environment tests (contract validation) have no window at all.
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined
}
