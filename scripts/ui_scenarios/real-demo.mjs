import { walk, REAL } from "./demo.mjs";

export const scenarios = {
  async "real-demo-walk"(page) {
    page.allowExternal(/dynamics\.com/);
    page.allowConsole(/ERR_NAME_NOT_RESOLVED/);
    await walk(page, REAL);
  }
};
