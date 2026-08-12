import { NextResponse } from "next/server";
import { SOURCES, type SourceKey } from "@/lib/import/sources";
import { buildTemplate } from "@/lib/import/template";

export const runtime = "nodejs";

/** GET /api/template/leads → a correct, fillable CSV for that source. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ source: string }> },
) {
  const { source } = await params;
  if (!(source in SOURCES)) {
    return NextResponse.json({ error: `No such source: ${source}` }, { status: 404 });
  }

  return new NextResponse(buildTemplate(source as SourceKey), {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="funnel-os-${source}-template.csv"`,
      "cache-control": "public, max-age=3600",
    },
  });
}
