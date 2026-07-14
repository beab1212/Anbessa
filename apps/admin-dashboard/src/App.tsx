import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TripsPage } from "./pages/TripsPage";

// Ops/support dashboard: live trip map, driver roster, payout review.
function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/trips" element={<TripsPage />} />
      </Routes>
    </BrowserRouter>
  );
}


function HomePage() {
  return (
    <main>
      <h1>Home Page</h1>
      <p>Welcome to the Ride App!</p>
      <a href="/trips">Trip Page</a>
    </main>
  );
}

export default App;
