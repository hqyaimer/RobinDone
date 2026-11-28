export const CLI_COMMAND_NAME = "robindone";
export const CLI_PROCESS_NAME = "robindone-cli";

interface ProcessTitleTarget {
  title: string;
}

export const setCliProcessTitle = (
  target: ProcessTitleTarget = process,
): void => {
  target.title = CLI_PROCESS_NAME;
};
