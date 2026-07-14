import { useQuery } from "@tanstack/react-query";
import { apiClient } from "../api/client";

export function TripsPage() {
  const { data } = useQuery({ queryKey: ["trips"], queryFn: () => apiClient.get("/api/trips").then((r) => r.data) });
  return <div>{/* render data as a table */}</div>;
}
