import {
  DEFAULT_FEEDBACK_TICKET_FRAMEWORK,
  type RobinDoneProvider,
  type FeedbackTicketFramework,
} from "@robindone/shared";

export function inferFeedbackFrameworkFromAgentProvider(
  _provider: RobinDoneProvider | null | undefined,
): FeedbackTicketFramework {
  return DEFAULT_FEEDBACK_TICKET_FRAMEWORK;
}
