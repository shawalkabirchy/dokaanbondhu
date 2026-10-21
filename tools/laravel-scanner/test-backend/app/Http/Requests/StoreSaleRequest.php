<?php

namespace App\Http\Requests;

use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

class StoreSaleRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    public function rules(): array
    {
        return [
            'customer_id' => ['nullable', 'integer', 'exists:parties,party_id'],
            'items' => ['required', 'array', 'min:1'],
            'items.*.part_id' => ['required', 'integer', 'exists:items,item_id'],
            'items.*.quantity' => ['required', 'integer', 'min:1'],
            'items.*.unit_price' => ['nullable', 'integer', 'min:0'],
            'payments' => ['sometimes', 'array'],
            'payments.*.method' => ['required', Rule::in(['cash', 'bkash'])],
            'payments.*.amount' => ['required', 'integer', 'min:1'],
            'note' => ['nullable', 'string', 'max:200'],
        ];
    }
}
