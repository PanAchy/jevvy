export const windowsHostFixture = (nodePath: string) => ({
  environment: { JEVVY_SMOKE_NODE: nodePath },
  source: (host: "opencode" | "claude") => `@echo off\r\n"%JEVVY_SMOKE_NODE%" "%~dp0fake-host.mjs" ${host} %*\r\n`,
})
