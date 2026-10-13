import { GetParameterCommand, SSMClient } from '@aws-sdk/client-ssm';
import { YouTube, refreshAccessToken, type ClientCredentials } from '@darkrelay/core';

/**
 * OAuth secrets live in SSM Parameter Store as SecureStrings (free, unlike
 * Secrets Manager), written by `darkrelay youtube connect`:
 *   <prefix>/google-client          {"clientId","clientSecret"}
 *   <prefix>/youtube/<connection>   {"refreshToken","channelId","channelTitle"}
 */
export const ssmPaths = {
  client: (prefix: string) => `${prefix}/google-client`,
  connection: (prefix: string, name: string) => `${prefix}/youtube/${name}`,
};

export interface ConnectionSecret {
  refreshToken: string;
  channelId: string;
  channelTitle: string;
}

export function youtubeConnections(prefix: string, ssm = new SSMClient({})) {
  const cache = new Map<string, Promise<YouTube>>();
  const read = async <T>(name: string): Promise<T> => {
    const r = await ssm.send(new GetParameterCommand({ Name: name, WithDecryption: true }));
    return JSON.parse(r.Parameter!.Value!) as T;
  };
  return (connection: string): Promise<YouTube> => {
    if (!cache.has(connection)) {
      cache.set(
        connection,
        (async () => {
          const creds = await read<ClientCredentials>(ssmPaths.client(prefix));
          const secret = await read<ConnectionSecret>(ssmPaths.connection(prefix, connection));
          return new YouTube(await refreshAccessToken(creds, secret.refreshToken));
        })(),
      );
    }
    return cache.get(connection)!;
  };
}
