import { describe, expect, it } from "vitest";
import { toolCallsInText } from "./llm";

// D188: a model (DeepSeek) that writes its tool call as text instead of sending it.

describe("tool calls written as text", () => {
  it("are read as calls, and their markup is never the answer", () => {
    const text =
      'Let me check. <｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="run_read_query"> <｜｜DSML｜｜ parameter name="sql" ' +
      'string="true">SELECT 1</｜｜DSML｜｜ parameter> <｜｜DSML｜｜ parameter name="limit" string="false">5' +
      "</｜｜DSML｜｜ parameter> </｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>";
    const read = toolCallsInText(text)!;
    expect(read.text).toBe("Let me check.");
    expect(read.calls).toEqual([
      { id: "text-call-1", name: "run_read_query", arguments: JSON.stringify({ sql: "SELECT 1", limit: 5 }) },
    ]);
  });

  it("markup cut short is dropped; plain text has none", () => {
    expect(toolCallsInText('<｜DSML｜calls> <｜DSML｜invoke name="find_parts">')).toEqual({
      calls: [],
      text: "",
    });
    expect(toolCallsInText("৮টা আছে, ৬,৪০০ টাকা।")).toBeNull();
  });
});
