/**
 * useServers — fetches the server list from the API.
 * Falls back to KNOWN_SERVERS (hardcoded) if the API is unavailable.
 */
import { useState, useEffect } from "react";
import { EqsoServer, KNOWN_SERVERS } from "./useEqsoClient";

export function useServers() {
  const [servers, setServers] = useState<EqsoServer[]>(KNOWN_SERVERS);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const base = import.meta.env.BASE_URL?.replace(/\/$/, "") ?? "";
    fetch(`${base}/api/servers`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.status)))
      .then((data: EqsoServer[]) => {
        if (Array.isArray(data) && data.length > 0) {
          // Always append the custom server option at the end
          const withCustom: EqsoServer[] = [
            ...data,
            {
              id: "custom",
              label: "Servidor personalizado...",
              description: "Introduce direccion y puerto manual",
              mode: "remote",
              host: "",
              port: 2171,
              defaultRooms: [],
            },
          ];
          setServers(withCustom);
        }
      })
      .catch(() => {
        /* keep KNOWN_SERVERS fallback */
      })
      .finally(() => setLoading(false));
  }, []);

  return { servers, loading };
}
