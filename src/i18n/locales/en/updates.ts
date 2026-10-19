import type { MessageCatalog } from "../../types.js";

export default {
  "updates.invalidSettings": "Update settings must contain autoCheck or an exact stable ignoredVersion.",
  "updates.invalidVersion": "Only exact stable release versions are supported.",
  "updates.invalidMetadata": "The release metadata is missing or invalid. Try checking again later.",
  "updates.notFound": "This package or release is not available in the public registry (HTTP {{status}}).",
  "updates.httpError": "The release registry returned HTTP {{status}}. Try checking again later.",
  "updates.checkFailed": "Could not check for updates. Try again later.",
  "updates.checkTimeout": "The update check timed out after 5 seconds. Try again later.",
  "updates.incompatibleNode": "This version requires Node.js {{required}}; the current runtime is {{current}}.",
  "updates.incompatibleOs": "This version does not support the current operating system ({{current}}).",
  "updates.incompatibleArch": "This version does not support the current CPU architecture ({{current}}).",
} satisfies MessageCatalog;
