import { useTranslation } from "react-i18next";
import { Note, Screen } from "../../src/ui";

export default function Chat() {
  const { t } = useTranslation();
  return (
    <Screen>
      <Note>{t("chat.coming")}</Note>
    </Screen>
  );
}
