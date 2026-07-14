import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TripsPage } from "./pages/TripsPage";

// Ops/support dashboard: live trip map, driver roster, payout review.
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/trips" element={<TripsPage />} />
      </Routes>
    </BrowserRouter>
  );
}
