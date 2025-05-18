import express from "express";
import twilio from "twilio";
import cors from "cors";
import "dotenv/config";
import stringSimilarity from "string-similarity";
import cron from "node-cron";
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

// Validate Twilio credentials
if (!accountSid || !authToken || !twilioPhoneNumber) {
  console.error("Twilio credentials are missing!");
  process.exit(1);
}

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
  // First create a map of registered centers by google_place_id for quick lookup
  const registeredMap = new Map();
  registeredCenters.forEach((rc) => {
    if (rc.google_place_id) {
      registeredMap.set(rc.google_place_id, rc);
    }
  });

  // Process Google results - only mark as registered if place_id matches exactly
  const processedGoogleResults = googleResults.map((center) => {
    const isRegistered = registeredMap.has(center.place_id);
    const registeredCenter = registeredMap.get(center.place_id);

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

  // Add all registered centers, even if not found in Google results
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

  // Combine results - now all registered centers will appear
  let allResults = [...unmatchedRegisteredCenters, ...processedGoogleResults];

  // Only apply filter if explicitly requested
  if (filterRegistered === "true") {
    allResults = allResults.filter((center) => center.isRegistered);
  }

  // Sort with registered first, then by distance
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
      maxResults = 60,
    } = req.query;

    if (!lat || !lng) {
      return res
        .status(400)
        .json({ error: "Latitude and longitude are required" });
    }

    // Debug: Log incoming coordinates
    console.log(`Searching near lat: ${lat}, lng: ${lng}, radius: ${radius}m`);

    // Get registered centers from Supabase
    const { data: registeredCenters, error: sbError } = await supabase
      .from("service_centers_view")
      .select("*");

    if (sbError) throw sbError;

    // Debug: Log registered centers count
    console.log(
      `Found ${registeredCenters.length} registered centers in database`
    );

    // Get nearby centers from Google Places API
    const searchParams = {
      location: { lat: parseFloat(lat), lng: parseFloat(lng) },
      radius: parseInt(radius),
      key: process.env.VITE_GOOGLE_MAPS_API_KEY,
    };

    let allGoogleResults = [];
    let placesResponse;

    try {
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

      allGoogleResults = placesResponse.data.results;

      // Pagination to get more results if available
      while (
        placesResponse.data.next_page_token &&
        allGoogleResults.length < maxResults
      ) {
        await new Promise((resolve) => setTimeout(resolve, 2000)); // Required delay

        const nextPageResponse = await googleMapsClient.placesNearby({
          params: {
            ...searchParams,
            pagetoken: placesResponse.data.next_page_token,
          },
        });

        allGoogleResults = [
          ...allGoogleResults,
          ...nextPageResponse.data.results,
        ];
        placesResponse = nextPageResponse;
      }
    } catch (googleError) {
      console.error(
        "Google Maps API error:",
        googleError.response?.data || googleError.message
      );
    }

    // Debug: Log Google results count
    console.log(`Found ${allGoogleResults.length} Google Places results`);

    // Process and return results
    const results = processResults(
      registeredCenters,
      allGoogleResults,
      lat,
      lng,
      filterRegistered
    );

    // Debug: Log final results count
    console.log(`Returning ${results.length} total results`);

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

// SMS Templates
function getUpcomingReminderTemplate(reminder, customer, vehicle) {
  return (
    `[CarMate] Service Reminder\n` +
    `Your ${vehicle.manufacturer} ${vehicle.model} is due for:\n` +
    `Service: ${reminder.service_type}\n` +
    `Date: ${new Date(reminder.reminder_date).toLocaleDateString("en-GB")}\n` +
    (reminder.mileage ? `Recommended Mileage: ${reminder.mileage}km\n` : "")
  );
}

function getFollowUpTemplate(reminder, customer, vehicle) {
  const daysLate = Math.floor(
    (new Date() - new Date(reminder.reminder_date)) / (1000 * 60 * 60 * 24)
  );

  return (
    `[CarMate] Important Follow-up\n` +
    `We noticed your ${vehicle.manufacturer} ${vehicle.model} missed its scheduled:\n` +
    `Service: ${reminder.service_type}\n` +
    `Original Due Date: ${new Date(reminder.reminder_date).toLocaleDateString(
      "en-GB"
    )} (${daysLate} day${daysLate !== 1 ? "s" : ""} ago)\n` +
    `\nDelaying service may affect your vehicle's performance and warranty coverage.\n`
  );
}

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

// Reminder Creation Endpoint
app.post("/create-reminder", async (req, res) => {
  try {
    const { customerId, vehicleId, serviceType, reminderDate, mileage, notes } =
      req.body;

    // Insert reminder
    const { data: reminder, error } = await supabase
      .from("reminders")
      .insert([
        {
          user_id: customerId,
          vehicle_id: vehicleId,
          service_type: serviceType,
          reminder_date: reminderDate,
          mileage: mileage,
          notes: notes,
        },
      ])
      .select()
      .single();

    if (error) throw error;

    // Get customer/vehicle details
    const { data: customer } = await supabase
      .from("profiles")
      .select("phone_number, username")
      .eq("id", customerId)
      .single();

    const { data: vehicle } = await supabase
      .from("vehicles")
      .select("manufacturer, model")
      .eq("id", vehicleId)
      .single();

    if (!customer?.phone_number) {
      throw new Error("Customer phone number not found");
    }

    // Send confirmation SMS
    const message =
      `[CarMate] Service Scheduled\n` +
      `Hello ${customer.username || "there"},\n` +
      `Your ${vehicle.manufacturer} ${vehicle.model}\n` +
      `Service: ${serviceType}\n` +
      `Scheduled: ${new Date(reminderDate).toLocaleDateString("en-GB")}\n` +
      (mileage ? `Mileage: ${mileage}km\n` : "");

    await client.messages.create({
      body: message,
      from: twilioPhoneNumber,
      to: customer.phone_number,
    });

    res.status(201).json({ success: true, reminder });
  } catch (error) {
    console.error("Reminder creation error:", error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

// Process Reminders Function
async function processReminders(testMode = false, testDate = new Date()) {
  const threeDaysLater = new Date(testDate);
  threeDaysLater.setDate(testDate.getDate() + 3);

  console.log(`Processing reminders between ${testDate} and ${threeDaysLater}`);

  const { data: reminders, error } = await supabase
    .from("reminders")
    .select(`*, user:user_id (*), vehicle:vehicle_id (*)`)
    .lte("reminder_date", threeDaysLater.toISOString())
    .eq("notification_sent", false)
    .order("reminder_date", { ascending: true });

  if (error) throw error;

  console.log(`Found ${reminders.length} reminders to process`);

  const results = [];
  for (const reminder of reminders) {
    try {
      const reminderDate = new Date(reminder.reminder_date);
      const daysUntilDue = Math.floor(
        (reminderDate - testDate) / (1000 * 60 * 60 * 24)
      );

      let message, templateType;
      if (daysUntilDue >= 0 && daysUntilDue <= 3) {
        message = getUpcomingReminderTemplate(
          reminder,
          reminder.user,
          reminder.vehicle
        );
        templateType = "upcoming";
      } else if (daysUntilDue < 0) {
        message = getFollowUpTemplate(
          reminder,
          reminder.user,
          reminder.vehicle
        );
        templateType = "followup";
      } else {
        continue;
      }

      if (testMode) {
        console.log(`[TEST] Would send to ${reminder.user.phone_number}:`);
        console.log(message);
      } else {
        const result = await client.messages.create({
          body: message,
          from: twilioPhoneNumber,
          to: reminder.user.phone_number,
        });
        console.log("Twilio response:", result.sid);
      }

      if (!testMode) {
        const { error: updateError } = await supabase
          .from("reminders")
          .update({
            notification_sent: true,
            last_notification_sent_at: new Date().toISOString(),
            notification_template_type: templateType,
          })
          .eq("id", reminder.id);

        if (updateError) throw updateError;
      }

      results.push({
        id: reminder.id,
        status: "processed",
        templateType,
        phone: reminder.user.phone_number,
        messagePreview: message.substring(0, 50) + "...",
      });
    } catch (err) {
      console.error(`Failed to process reminder ${reminder.id}:`, err);
      results.push({
        id: reminder.id,
        status: "failed",
        error: err.message,
      });
    }
  }

  return {
    success: true,
    remindersProcessed: results.length,
    results,
  };
}

// Scheduled job (runs daily at 9am KL time)
cron.schedule(
  "0 9 * * *",
  () => {
    console.log("Running scheduled reminder job at", new Date());
    processReminders(false)
      .then((result) => console.log("Cron job completed:", result))
      .catch((err) => console.error("Cron job failed:", err));
  },
  {
    scheduled: true,
    timezone: "Asia/Kuala_Lumpur",
  }
);

// Endpoint to trigger immediate processing
app.post("/process-reminders", async (req, res) => {
  try {
    const { testMode, testDate } = req.body;
    const currentDate = testDate ? new Date(testDate) : new Date();

    const result = await processReminders(testMode, currentDate);
    res.json(result);
  } catch (err) {
    console.error("Error in process-reminders endpoint:", err);
    res.status(500).json({
      error: err.message,
    });
  }
});

// Start server with 0.0.0.0 binding for Render
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
});
