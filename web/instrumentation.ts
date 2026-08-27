// Keep instrumentation free of application imports. Next compiles this file
// separately, and importing the market catalog would pull the Node-only
// PostgreSQL client into the instrumentation bundle.
export async function register() {
    return;
}
