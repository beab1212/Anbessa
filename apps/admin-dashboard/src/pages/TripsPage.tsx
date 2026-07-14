import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

export function TripsPage() {
  // const { data } = useQuery({ queryKey: ["trips"], queryFn: () => apiClient.get("/api/trips").then((r) => r.data) });
  return (
    <div>
      <h1>Hello Vite + React!</h1>
    </div>
  );
}
