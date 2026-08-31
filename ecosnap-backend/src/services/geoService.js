function getNeighborhood(lat, lng) {
  // Yaba
  if (
    lat >= 6.48 &&
    lat <= 6.53 &&
    lng >= 3.36 &&
    lng <= 3.40
  ) {
    return "Yaba";
  }

  // Surulere
  if (
    lat >= 6.47 &&
    lat <= 6.52 &&
    lng >= 3.32 &&
    lng <= 3.36
  ) {
    return "Surulere";
  }

  // Ikeja
  if (
    lat >= 6.57 &&
    lat <= 6.65 &&
    lng >= 3.32 &&
    lng <= 3.39
  ) {
    return "Ikeja";
  }

  // Default for locations outside our demo areas
  return "Unknown";
}

module.exports = {
  getNeighborhood,
};