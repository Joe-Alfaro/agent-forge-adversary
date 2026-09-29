// jsdom does not implement scrolling; the router calls it after each navigation.
window.scrollTo = () => undefined
