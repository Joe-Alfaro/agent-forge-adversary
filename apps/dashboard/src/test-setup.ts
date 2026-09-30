import { configure } from '@testing-library/react'

// Under a loaded, parallel full-suite run, the 1 s default for findBy/waitFor is too tight.
configure({ asyncUtilTimeout: 3_000 })

// jsdom does not implement scrolling; the router calls it after each navigation.
// Node-environment tests (contract validation) have no window at all.
if (typeof window !== 'undefined') {
  window.scrollTo = () => undefined
}
