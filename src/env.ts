/** Read IOS_DEVICE_MCP_<name>, falling back to the pre-rename IPHONE_MCP_<name>. */
export function env(name: string): string | undefined {
  return process.env[`IOS_DEVICE_MCP_${name}`] ?? process.env[`IPHONE_MCP_${name}`];
}
