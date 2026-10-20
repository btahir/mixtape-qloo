import { dispatch } from "@/lib/server/api";
export const maxDuration = 60;
async function handler(
  req: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return dispatch(req, (await context.params).path);
}
export { handler as GET, handler as POST, handler as PATCH, handler as DELETE };
