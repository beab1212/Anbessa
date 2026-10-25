import { BrowserRouter, Routes, Route } from "react-router-dom";
import { TripsPage } from "./pages/TripsPage";

// The Anbessa web app: staff dashboard, fleet portal and corporate portal in one app.
// Pages are shown per the roles in the access token; the APIs enforce the same rules.
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
