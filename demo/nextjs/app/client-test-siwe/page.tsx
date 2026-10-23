import { baseURL } from "@/lib/demo-url";
import { WalletClientTest } from "./wallet-client";

export default function Page() {
	return <WalletClientTest origin={baseURL} />;
}
