<?php

namespace App\Http\Controllers;

use App\Http\Requests\StoreSaleRequest;
use App\Models\Sale;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

class SaleController extends Controller
{
    /** A sale on test shop B's tables: lines at the given price (else the customer's), stock taken, the due added. */
    public function store(StoreSaleRequest $request)
    {
        $data = $request->validated();

        return DB::transaction(function () use ($data) {
            $party = isset($data['customer_id'])
                ? DB::table('parties')->where('party_id', $data['customer_id'])->lockForUpdate()->first()
                : null;
            $lines = [];
            $total = 0;
            foreach ($data['items'] as $item) {
                $stock = (float) DB::table('branch_stock')->where('item_id', $item['part_id'])->sum('qty');
                if ($stock < $item['quantity']) {
                    return response()->json(['message' => 'Not enough stock.'], 422);
                }
                $price = $item['unit_price'] ?? $this->priceOf($item['part_id'], $party);
                $total += $price * $item['quantity'];
                $lines[] = ['item_id' => $item['part_id'], 'quantity' => $item['quantity'], 'unit_price_taka' => $price];
            }
            $paid = (int) collect($data['payments'] ?? [])->sum('amount');
            $due = max(0, $total - $paid);
            if (! $party && $due > 0) {
                return response()->json(['message' => 'A walk-in sale is paid in full.'], 422);
            }
            $sale = Sale::create([
                'party_id' => $party?->party_id,
                'total_taka' => $total,
                'paid_taka' => $paid,
                'due_taka' => $due,
                'status' => 'posted',
                'note' => $data['note'] ?? null,
            ]);
            foreach ($lines as $line) {
                $sale->lines()->create($line);
                $this->takeStock($line['item_id'], $line['quantity']);
            }
            if ($party && $due > 0) {
                DB::table('parties')->where('party_id', $party->party_id)->increment('balance', $due);
            }

            return response()->json(['sale' => $sale->fresh('lines')], 201);
        });
    }

    public function show(Sale $sale)
    {
        return response()->json(['sale' => $sale->load('lines')]);
    }

    /** Voids a sale: its stock back to the first branch, its due off the customer's balance. */
    public function void(Request $request, Sale $sale)
    {
        $request->validate(['reason' => ['required', 'string', 'max:200']]);
        if ($sale->status === 'void') {
            return response()->json(['message' => 'The sale is void already.'], 422);
        }

        return DB::transaction(function () use ($sale) {
            foreach ($sale->lines as $line) {
                $first = DB::table('branch_stock')->where('item_id', $line->item_id)->orderBy('stock_id')->first();
                DB::table('branch_stock')->where('stock_id', $first->stock_id)->increment('qty', $line->quantity);
            }
            if ($sale->party_id && $sale->due_taka > 0) {
                DB::table('parties')->where('party_id', $sale->party_id)->decrement('balance', $sale->due_taka);
            }
            $sale->update(['status' => 'void']);

            return response()->json(['sale' => $sale->fresh('lines')]);
        });
    }

    /** The newest price: a mechanic's workshop rate, a dealer's rate, else the sale rate; whole taka. */
    private function priceOf(int $itemId, ?object $party): int
    {
        $price = DB::table('item_prices')->where('item_id', $itemId)->orderByDesc('effective_from')->first();
        $rate = match ($party?->party_kind) {
            'Mechanic' => $price->workshop_rate ?? $price->sale_rate,
            'Dealer' => $price->dealer_rate ?? $price->sale_rate,
            default => $price->sale_rate,
        };

        return (int) round((float) $rate);
    }

    /** Takes the quantity from the branches that hold the item, the fullest first. */
    private function takeStock(int $itemId, int $quantity): void
    {
        $rows = DB::table('branch_stock')->where('item_id', $itemId)->where('qty', '>', 0)->orderByDesc('qty')->get();
        foreach ($rows as $row) {
            $take = min($quantity, (float) $row->qty);
            DB::table('branch_stock')->where('stock_id', $row->stock_id)->decrement('qty', $take);
            $quantity -= $take;
            if ($quantity <= 0) {
                return;
            }
        }
    }
}
