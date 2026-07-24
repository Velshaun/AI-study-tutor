"""Service layer: storage, source parsing and AI analysis.

Routers stay thin — they validate input and delegate here. Everything in this
package is import-safe without credentials; missing keys raise only when a
function is actually called, so the app still boots for local development.
"""
