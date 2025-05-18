import express from "express";
import twilio from "twilio";
import cors from "cors";
import "dotenv/config";
import stringSimilarity from "string-similarity";
import supabase from "./supabaseServerClient.js";
import { Client } from "@googlemaps/google-maps-services-js";

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(express.json());
app.use(
  cors({
    origin: [
      "https://carmate-chi.vercel.app",
      "http://localhost:5173",
      "http://127.0.0.1:5173",
    ],
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

// Health check endpoint (required by Render)
app.get("/health", (req, res) => {
  res.status(200).json({ status: "healthy" });
});

// Twilio setup
const accountSid = process.env.VITE_TWILIO_ACCOUNT_SID;
const authToken = process.env.VITE_TWILIO_AUTH_TOKEN;
const twilioPhoneNumber = process.env.VITE_TWILIO_PHONE_NUMBER;
const client = twilio(accountSid, authToken);
const googleMapsClient = new Client({});

// Helper function to calculate distance
function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371; // Earth radius in km
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

// Add this after calculateDistance() but before your /api/service-centers/nearby endpoint
function processResults(
  registeredCenters,
  googleResults,
  lat,
  lng,
  filterRegistered
) {
  // Map Google results with registration status
  const processedGoogleResults = googleResults.map((center) => {
    const isRegistered = registeredCenters.some((rc) => {
      // 1. Check if place_id matches
      if (rc.google_place_id === center.place_id) return true;

      // 2. Check name similarity
      const nameSimilarity = stringSimilarity.compareTwoStrings(
        rc.service_center_name.toLowerCase(),
        center.name.toLowerCase()
      );
      if (nameSimilarity > 0.8) return true;

      // 3. Check address similarity
      const addressSimilarity = stringSimilarity.compareTwoStrings(
        (rc.service_center_address || "").toLowerCase(),
        (center.vicinity || "").toLowerCase()
      );
      if (addressSimilarity > 0.7) return true;

      // 4. Check location proximity (within 100m)
      if (rc.service_center_lat && rc.service_center_lng) {
        return (
          calculateDistance(
            rc.service_center_lat,
            rc.service_center_lng,
            center.geometry?.location.lat,
            center.geometry?.location.lng
          ) < 0.1
        );
      }

      return false;
    });

    const registeredCenter = registeredCenters.find(
      (rc) => rc.google_place_id === center.place_id
    );

    return {
      id: center.place_id,
      name: center.name,
      address: center.vicinity,
      location: center.geometry?.location,
      distance: calculateDistance(
        lat,
        lng,
        center.geometry?.location.lat,
        center.geometry?.location.lng
      ),
      isRegistered,
      registeredData: registeredCenter || null,
      rating: center.rating,
      user_ratings_total: center.user_ratings_total,
      googleMapsUrl: `https://www.google.com/maps/place/?q=place_id:${center.place_id}`,
      source: "google",
    };
  });

  // Add registered centers not found in Google results
  const unmatchedRegisteredCenters = registeredCenters
    .filter(
      (rc) =>
        !processedGoogleResults.some(
          (r) => r.isRegistered && r.registeredData?.id === rc.id
        )
    )
    .map((rc) => ({
      id: rc.id,
      name: rc.service_center_name,
      address: rc.service_center_address,
      location:
        rc.service_center_lat && rc.service_center_lng
          ? { lat: rc.service_center_lat, lng: rc.service_center_lng }
          : null,
      distance:
        rc.service_center_lat && rc.service_center_lng
          ? calculateDistance(
              lat,
              lng,
              rc.service_center_lat,
              rc.service_center_lng
            )
          : null,
      isRegistered: true,
      registeredData: rc,
      rating: rc.average_rating,
      googleMapsUrl: rc.google_place_id
        ? `https://www.google.com/maps/place/?q=place_id:${rc.google_place_id}`
        : null,
      source: "supabase",
    }));

  // Combine all results
  let allResults = [
    ...unmatchedRegisteredCenters,
    ...processedGoogleResults.filter((center) => !center.isRegistered),
  ];

  // Apply filter if requested
  if (filterRegistered === "true") {
    allResults = allResults.filter((center) => center.isRegistered);
  }

  // Sort results (registered first, then by distance)
  return allResults.sort((a, b) => {
    if (a.isRegistered && !b.isRegistered) return -1;
    if (!a.isRegistered && b.isRegistered) return 1;
    if (a.distance === null) return 1;
    if (b.distance === null) return -1;
    return a.distance - b.distance;
  });
}

// Service Centers Endpoint
app.get("/api/service-centers/nearby", async (req, res) => {
  try {
    const {
      lat,
      lng,
      searchQuery,
      filterRegistered,
      radius = 10000,
    } = req.query;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ error: "Latitude and longitude are required" });
    }

    // Get registered centers from Supabase
    const { data: registeredCenters, error: sbError } = await supabase
      .from("service_centers_view")
      .select("*");

    if (sbError) throw sbError;

    // Get nearby centers from Google Places API
    const searchParams = {
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      radius: parseInt(radius),
      key: process.env.VITE_GOOGLE_MAPS_API_KEY,
    };

    let placesResponse;
    if (searchQuery) {
      placesResponse = await googleMapsClient.textSearch({
        params: {
          ...searchParams,
          query: `${searchQuery} car service OR auto repair OR vehicle maintenance`,
        },
      });
    } else {
      placesResponse = await googleMapsClient.placesNearby({
        params: {
          ...searchParams,
          type: "car_repair",
          keyword: "car service OR auto repair OR vehicle maintenance",
        },
      });
    }

    // Process and return results
    const results = processResults(
      registeredCenters,
      placesResponse.data.results,
      lat,
      lng,
      filterRegistered
    );
    res.status(200).json(results);
  } catch (error) {
    console.error("Error:", error);
    res.status(500).json({
      error: "Internal server error",
      details:
        process.env.NODE_ENV === "development" ? error.message : undefined,
    });
  }
});

// SMS Endpoint
app.post("/api/send-sms", async (req, res) => {
  try {
    const { to, message } = req.body;
    if (!to || !message) {
      return res.status(400).json({ error: "Missing phone number or message" });
    }

    const sms = await client.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: to,
    });

    res.json({ success: true, sid: sms.sid });
  } catch (error) {
    console.error("Twilio error:", error);
    res.status(500).json({
      error: error.message,
      details: error.moreInfo || null,
    });
  }
});

// Start server with 0.0.0.0 binding for Render
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
