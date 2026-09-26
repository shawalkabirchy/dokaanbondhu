export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// TEMPORARY, for proof P5 only (removed after it): an NDJSON reply with the headers of spec 8.5, sent in pieces
// with pauses, one line split across two writes and one unknown event type. Answers 404 in a production build.

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function GET(): Promise<Response> {
  if (process.env.NODE_ENV === "production") return new Response(null, { status: 404 });
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => controller.enqueue(encoder.encode(text));
      send('{"type":"status","state":"UNDERSTANDING","label_key":"status.searching"}\n');
      await pause(400);
      send('{"type":"text","seq":0,"text":"এক্সিও ২০১৪-এর সামনের প্যাড দুই রকম আছে');
      await pause(400);
      send('।"}\n{"type":"hologram","x":1}\n');
      await pause(400);
      send('{"type":"text","seq":1,"text":"দুটোই B-3 তাকে।","final":true}\n');
      await pause(400);
      send('{"type":"done","turn_id":"p5-test","state":"IDLE","timings_ms":{"total":1600}}\n');
      controller.close();
    },
  });
  return new Response(body, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
