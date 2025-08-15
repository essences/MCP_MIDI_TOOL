declare module 'midi' {
  export class Output {
    constructor();
    getPortCount(): number;
    getPortName(index: number): string;
    openPort(index: number): void;
    closePort(): void;
    sendMessage(message: number[]): void;
  }
}
