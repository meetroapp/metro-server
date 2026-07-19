"use strict";

const GOVERNED_MEDIA_ERROR = Object.freeze({
  status: 400,
  code: "GOVERNED_MEDIA_REFERENCE_REQUIRED",
  message: "Media is not available for this workflow.",
});

function hasMediaValue(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

function findUnsupportedMediaField(body, fields) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  return fields.find((field) => hasMediaValue(body[field])) || null;
}

function rejectUnsupportedMedia(req, res, fields) {
  const field = findUnsupportedMediaField(req.body, fields);
  if (!field) return false;

  res.status(GOVERNED_MEDIA_ERROR.status).json({
    success: false,
    code: GOVERNED_MEDIA_ERROR.code,
    error: GOVERNED_MEDIA_ERROR.message,
  });
  return true;
}

module.exports = {
  GOVERNED_MEDIA_ERROR,
  findUnsupportedMediaField,
  hasMediaValue,
  rejectUnsupportedMedia,
};
