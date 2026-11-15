import type { APIGatewayProxyEventV2, APIGatewayProxyResultV2 } from 'aws-lambda';

/**
 * The catch-all behind every path the API has no route for.
 *
 * Without it, an unrouted path gets API Gateway's own 404, which carries no
 * CORS headers. The browser then refuses to let the page read the response
 * at all, and `fetch` rejects with a bare "NetworkError" naming neither the
 * status nor the path — which is how a missing route once looked like a
 * broken network for far longer than it should have.
 *
 * Reaching a route, even this one, is enough for API Gateway to add the
 * CORS headers, so the dashboard can show what actually happened. Routes
 * come from the table in `@darkrelay/core/routes`, so this should only ever
 * answer a stale client or a hand-typed URL.
 */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyResultV2> => {
  const { method, path } = event.requestContext.http;
  console.log(JSON.stringify({ message: 'No route for request', method, path }));
  return {
    statusCode: 404,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ error: `No route for ${method} ${path}` }),
  };
};
